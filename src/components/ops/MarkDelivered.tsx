"use client";
import { useRef, useState } from "react";
import { boundedWait } from "@/lib/boundedWait";
import { markVideoDeliveredAction } from "@/app/ops/actions";
import { Button } from "@/components/ui/Action";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { SaveStatus } from "@/components/ui/SaveStatus";

/**
 * MARK AS DELIVERED (Jordan, Oct 13 2026) — the ONE manual step left on a
 * listing video. The hub records the upload itself when the Aryeo listing shows
 * the new video, and Aryeo's delivery event records the send; this button is
 * for when that can't tell. One confirmation records both. It sends nothing to
 * Aryeo or the client.
 */
export function MarkDelivered({ submissionId, fingerprint, onDelivered }: { submissionId: string; fingerprint: string; onDelivered?: (sent?: boolean) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const guard = useRef(false);
  function save() {
    if (guard.current || done) return;
    setConfirming(false);
    guard.current = true;
    setBusy(true);
    setMessage(null);
    void (async () => {
      try {
        const result = await boundedWait(markVideoDeliveredAction(submissionId, fingerprint), 20_000);
        if (!result || typeof result.ok !== "boolean" || typeof result.message !== "string") throw new Error("Unconfirmed delivery");
        if (!result.ok) { setMessage(result.message); return; }
        setDone(true);
        onDelivered?.(result.sent !== false);
      } catch {
        setMessage("Could not confirm the delivery record. Refresh to see where this video stands; you do not need to upload or send it again.");
      } finally { guard.current = false; setBusy(false); }
    })();
  }
  return <div className="contents">
    <Button className="border-transparent bg-emerald-700 text-white hover:bg-emerald-800 hover:brightness-100" busy={busy} busyLabel="Saving…" disabled={done} onClick={() => { if (!guard.current && !done) setConfirming(true); }}>{done ? "Delivered" : "Mark as delivered"}</Button>
    {confirming && <ModalDialog label="Confirm delivered" onCancel={() => setConfirming(false)} className="max-w-md">
      <h3 className="text-lg font-semibold">Confirm delivered</h3>
      <p className="mt-2 text-sm">Confirm this exact version is on the Aryeo listing and the listing has been delivered to the client. This records it; it sends no message.</p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" data-modal-initial-focus onClick={() => setConfirming(false)}>Cancel</Button>
        <Button className="border-transparent bg-emerald-700 text-white hover:bg-emerald-800" onClick={save}>Confirm delivered</Button>
      </div>
    </ModalDialog>}
    {message && <SaveStatus state="error" message={message} className="basis-full w-full" />}
  </div>;
}
