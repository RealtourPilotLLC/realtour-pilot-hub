"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { confirmedAryeoDestination } from "@/lib/videoDestinationReceipt";

// ---------------------------------------------------------------------------
// "UPLOAD TO ARYEO INSTEAD" FOR A BRANDING VIDEO (back Oct 21 2026; Jordan:
// branding videos "possibly sometimes" go to Aryeo). Shown on the Video Review
// Room's portal row for a branding video that has not gone to the portal yet.
// The press only switches THIS version's destination (lib/
// videoDeliveryDestination.chooseAryeoDelivery): the portal stops waiting for
// it and it joins Ready to send, where a person presses Upload to Aryeo and
// send (or does it by hand). Nothing is uploaded, delivered or sent by the
// press itself. A lost answer is recovered with a read-only GET, never a
// second write.
// ---------------------------------------------------------------------------

export function ChooseAryeoDelivery({ submissionId, fingerprint, onChosen }: { submissionId: string; fingerprint: string; onChosen?: () => void }) {
  const router = useRouter();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [chosen, setChosen] = useState(false);
  const done = () => {
    setChosen(true);
    onChosen?.();
    router.refresh();
  };
  const choose = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    const request = async (method: "POST" | "GET") => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), method === "POST" ? 8000 : 5000);
      try {
        const query = new URLSearchParams({ submissionId, fingerprint });
        const response = await fetch(`/api/ops/video-destination${method === "GET" ? `?${query}` : ""}`, {
          method, cache: "no-store", credentials: "same-origin", signal: controller.signal,
          headers: { Accept: "application/json", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
          ...(method === "POST" ? { body: JSON.stringify({ submissionId, fingerprint }) } : {}),
        });
        if (confirmedAryeoDestination(response, submissionId, fingerprint)) return { ok: true };
        return await response.json() as { ok: boolean; message?: string; unconfirmed?: boolean };
      } finally { clearTimeout(timer); }
    };
    try {
      let result;
      try { result = await request("POST"); } catch { /* recover saved choice below */ }
      if (result?.ok) { done(); return; }
      if (!result || result.unconfirmed) {
        const saved = await request("GET");
        if (saved.ok) { done(); return; }
      }
      setError(result?.message ?? "Couldn't confirm the destination. Try again; a saved choice is kept.");
    } catch { setError("Couldn't confirm the destination. Try again; a saved choice is kept."); }
    finally { lock.current = false; setBusy(false); }
  };
  if (chosen) return <p role="status" className="mt-1 text-sm text-muted">Aryeo chosen. It&rsquo;s in Ready to send now: press Upload to Aryeo and send there, or upload it by hand.</p>;
  return <div className="mt-1 text-sm">
    <button type="button" onClick={choose} disabled={busy} className="inline-flex min-h-11 items-center rounded px-1 text-muted underline underline-offset-4 hover:text-foreground disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-brand">{busy ? "Choosing Aryeo…" : "Upload to Aryeo instead"}</button>
    {error && <p role="alert" className="mt-1 break-words text-danger">{error}</p>}
  </div>;
}
