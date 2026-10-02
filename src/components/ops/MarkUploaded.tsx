"use client";
import { useRef, useState } from "react";
import { boundedWait } from "@/lib/boundedWait";
import { recordUploadRequest } from "@/lib/recordUploadRequest";
import { Button } from "@/components/ui/Action";
import { SaveStatus } from "@/components/ui/SaveStatus";

export function MarkUploaded({ submissionId, fingerprint, onUploaded }: { submissionId: string; fingerprint: string; onUploaded?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const guard = useRef(false);
  const key = `rtp:upload-record:${submissionId}`;
  function save() {
    if (guard.current || done) return;
    if (!window.confirm("Confirm you would like to mark this as uploaded.")) return;
    try {
      const previous = sessionStorage.getItem(key);
      if (previous && JSON.parse(previous).fingerprint !== fingerprint) {
        setMessage("The file changed since your previous attempt. Reopen the exact uploaded version before marking it."); return;
      }
      sessionStorage.setItem(key, JSON.stringify({ attempt: crypto.randomUUID(), fingerprint }));
    } catch { setMessage("Browser recovery storage is unavailable. Nothing was submitted."); return; }
    guard.current = true;
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        const result = await boundedWait(recordUploadRequest(submissionId, fingerprint), 15_000);
        if (!result || typeof result.ok !== "boolean" || typeof result.message !== "string" || result.unconfirmed) throw new Error("Unconfirmed receipt");
        if (!result.ok) {
          try { sessionStorage.removeItem(key); } catch { /* Keep the refusal visible. */ }
          setMessage(result.message); return;
        }
        setDone(true);
        try { sessionStorage.removeItem(key); } catch { /* Saved server receipt is authoritative. */ }
        onUploaded?.();
      } catch {
        setMessage("Could not confirm the upload record. Try Mark as Uploaded again; this will preserve any existing record. You do not need to upload the file again.");
      } finally { guard.current = false; setBusy(false); }
    })();
  }
  return <div className="space-y-2">
    <Button className="border-transparent bg-emerald-700 text-white hover:bg-emerald-800 hover:brightness-100" busy={busy} busyLabel="Saving…" disabled={done} onClick={save}>{done ? "Uploaded" : "Mark as Uploaded"}</Button>
    {message && <SaveStatus state="error" message={message} className="block" />}
  </div>;
}
