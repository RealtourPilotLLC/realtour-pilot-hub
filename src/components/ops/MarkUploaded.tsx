"use client";
import { useEffect, useRef, useState } from "react";
import { boundedWait } from "@/lib/boundedWait";
import { useRouter } from "next/navigation";
import { markVideoUploadedAction } from "@/app/ops/actions";
import { Button } from "@/components/ui/Action";
import { SaveStatus } from "@/components/ui/SaveStatus";

export function MarkUploaded({ submissionId, fingerprint }: { submissionId: string; fingerprint: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const guard = useRef(false);
  const [status, setStatus] = useState<"error" | "saved">("error");
  const key = `rtp:upload-record:${submissionId}`;
  useEffect(() => { queueMicrotask(() => { try { setHeld(Boolean(sessionStorage.getItem(key))); } catch { setHeld(true); } }); }, [key]);
  function save(reconcile = false) {
    if (guard.current || (held && !reconcile)) return;
    let attempt: string;
    try {
      if (reconcile && sessionStorage.getItem(key)) {
        const earlier = JSON.parse(sessionStorage.getItem(key)!);
        if (earlier.fingerprint !== fingerprint) { setHeld(true); setStatus("error"); setMessage("The final file changed while its earlier upload record was unconfirmed. Review that exact version before recording a replacement."); return; }
      }
      if (!reconcile && sessionStorage.getItem(key)) { setHeld(true); return; }
      attempt = JSON.stringify({ attempt: crypto.randomUUID(), fingerprint });
      sessionStorage.setItem(key, attempt);
    } catch { setHeld(true); setMessage("Browser recovery storage is unavailable. Nothing was submitted."); return; }
    guard.current = true;
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        const result = await boundedWait(markVideoUploadedAction(submissionId, fingerprint), 15_000);
        if (!result || typeof result.ok !== "boolean" || typeof result.message !== "string") throw new Error("Invalid save response");
        if (result.unconfirmed) throw new Error("Upload receipt is unconfirmed");
        setStatus(result.ok ? "saved" : "error");
        setMessage(result.message);
        if (reconcile && !result.ok) { setHeld(true); setMessage(`${result.message} The earlier upload record remains unconfirmed.`); return; }
        try {
          if (sessionStorage.getItem(key) === attempt) sessionStorage.removeItem(key);
          setHeld(Boolean(sessionStorage.getItem(key)));
        } catch { setHeld(true); setMessage(`${result.message} Inspect this version before another action; the browser recovery guard could not be cleared.`); }
        if (result.ok) router.refresh();
      } catch { setHeld(true); setStatus("error"); setMessage("Upload status is unconfirmed. Refresh or reconcile this exact version before another action."); }
      finally { guard.current = false; setBusy(false); }
    })();
  }
  return <div className="space-y-2">
    <Button className="border-transparent bg-emerald-700 text-white hover:bg-emerald-800 hover:brightness-100" busy={busy} busyLabel="Saving…" disabled={held} onClick={() => save()}>Mark as Uploaded</Button>
    {message && <SaveStatus state={status} message={message} className="block" />}
    {held && <div className="space-y-2 text-sm"><p>Upload status is unconfirmed. Check this version before another action.</p><Button variant="secondary" busy={busy} onClick={() => save(true)}>Reconcile upload record</Button></div>}
  </div>;
}
