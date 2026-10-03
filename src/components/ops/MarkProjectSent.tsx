"use client";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/Action";
import { ModalDialog } from "@/components/ui/ModalDialog";
import { SaveStatus } from "@/components/ui/SaveStatus";
import { boundedWait } from "@/lib/boundedWait";
import { confirmedProjectDeliveryResponse, isUploadedTarget, type GroupDeliveryResult, type UploadedTarget } from "@/lib/uploadedDeliveryGroups";

export function MarkProjectSent({ projectId, cuts, onRecorded }: { projectId: string; cuts: UploadedTarget[]; onRecorded: (cuts: UploadedTarget[]) => void }) {
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  const guard = useRef(false);
  function save() {
    if (guard.current) return;
    guard.current = true; setConfirming(false); setBusy(true); setMessage(null);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
    void (async () => {
      try {
        const attemptId = crypto.randomUUID();
        const result: GroupDeliveryResult = await boundedWait((async () => {
          const response = await fetch("/api/ops/project-sent", { method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
            headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ projectId, cuts, attemptId }) });
          if (response.redirected) throw new Error("Delivery response redirected");
          return confirmedProjectDeliveryResponse(response, projectId, cuts, attemptId) ?? response.json();
        })(), 15_000);
        if (typeof result?.ok !== "boolean" || typeof result.message !== "string" || !Array.isArray(result.completed)
          || !result.completed.every(v => isUploadedTarget(v) && cuts.some(c => c.submissionId === v.submissionId && c.fingerprint === v.fingerprint))
          || (result.ok && (new Set(result.completed.map(v => v.submissionId)).size !== cuts.length || result.unconfirmed))) throw new Error("Unconfirmed delivery receipt");
        if (!result.ok) setMessage(result.message);
        if (result.completed.length) onRecorded(result.completed);
      } catch { setMessage("Could not confirm the delivery records. Try Mark as sent again; existing records will be preserved. You do not need to send the files again."); }
      finally { clearTimeout(timer); guard.current = false; setBusy(false); }
    })();
  }
  return <div className="contents">
    <Button className="border-transparent bg-emerald-700 text-white hover:bg-emerald-800" busy={busy} busyLabel="Saving…" onClick={() => { if (!guard.current) setConfirming(true); }}>Mark as sent</Button>
    {message && <SaveStatus state="error" message={message} className="w-full" />}
    {confirming && <ModalDialog label="Confirm sent" onCancel={() => setConfirming(false)} className="max-w-md">
      <h3 className="text-lg font-semibold">Confirm sent</h3>
      <p className="mt-2 text-sm">Confirm these {cuts.length} uploaded video{cuts.length === 1 ? " has" : "s have"} been sent to the client. This records delivery and sends no message.</p>
      <div className="mt-5 flex flex-wrap justify-end gap-2"><Button variant="secondary" data-modal-initial-focus onClick={() => setConfirming(false)}>Cancel</Button><Button onClick={save}>Confirm sent</Button></div>
    </ModalDialog>}
  </div>;
}
