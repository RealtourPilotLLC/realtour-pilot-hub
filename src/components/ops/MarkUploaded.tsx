"use client";
import { useRef, useState } from "react";
import { boundedWait } from "@/lib/boundedWait";
import { recordUploadRequest } from "@/lib/recordUploadRequest";
import { Button } from "@/components/ui/Action";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { SaveStatus } from "@/components/ui/SaveStatus";

export function MarkUploaded({ submissionId, fingerprint, onUploaded }: { submissionId: string; fingerprint: string; onUploaded?: (sent?: boolean) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const guard = useRef(false);
  const key = `rtp:upload-record:${submissionId}`;
  function save() {
    if (guard.current || done) return;
    setConfirming(false);
    let recoverExisting = false;
    try {
      const previous = sessionStorage.getItem(key);
      if (previous && JSON.parse(previous).fingerprint !== fingerprint) {
        setMessage("The file changed since your previous attempt. Reopen the exact uploaded version before marking it."); return;
      }
      recoverExisting = !!previous;
      sessionStorage.setItem(key, JSON.stringify({ attempt: crypto.randomUUID(), fingerprint }));
    } catch { setMessage("Browser recovery storage is unavailable. Nothing was submitted."); return; }
    guard.current = true;
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        const result = await boundedWait(recordUploadRequest(submissionId, fingerprint, recoverExisting), 20_000);
        if (!result || typeof result.ok !== "boolean" || typeof result.message !== "string" || result.unconfirmed) throw new Error("Unconfirmed receipt");
        if (!result.ok) {
          try { sessionStorage.removeItem(key); } catch { /* Keep the refusal visible. */ }
          setMessage(result.message); return;
        }
        setDone(true);
        try { sessionStorage.removeItem(key); } catch { /* Saved server receipt is authoritative. */ }
        onUploaded?.(result.sent);
      } catch {
        setMessage("Could not confirm the upload record. Try Mark as Uploaded again; this will preserve any existing record. You do not need to upload the file again.");
      } finally { guard.current = false; setBusy(false); }
    })();
  }
  return <div className="contents">
    <Button className="border-transparent bg-emerald-700 text-white hover:bg-emerald-800 hover:brightness-100" busy={busy} busyLabel="Saving…" disabled={done} onClick={() => { if (!guard.current && !done) setConfirming(true); }}>{done ? "Uploaded" : "Mark as Uploaded"}</Button>
    {confirming && <ModalDialog label="Confirm upload" onCancel={() => setConfirming(false)} className="max-w-md">
      <h3 className="text-lg font-semibold">Confirm upload</h3>
      <p className="mt-2 text-sm">Confirm you would like to mark this as uploaded.</p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" data-modal-initial-focus onClick={() => setConfirming(false)}>Cancel</Button>
        <Button className="border-transparent bg-emerald-700 text-white hover:bg-emerald-800" onClick={save}>Confirm uploaded</Button>
      </div>
    </ModalDialog>}
    {message && <SaveStatus state="error" message={message} className="basis-full w-full" />}
  </div>;
}
