"use client";
import { useRef, useState } from "react";
import { confirmedAryeoDestination } from "@/lib/videoDestinationReceipt";

export function ChooseAryeoDelivery({ submissionId, fingerprint, onChosen }: { submissionId: string; fingerprint: string; onChosen: () => void }) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
      if (result?.ok) { onChosen(); return; }
      if (!result || result.unconfirmed) {
        const saved = await request("GET");
        if (saved.ok) { onChosen(); return; }
      }
      setError(result?.message ?? "Could not confirm the destination. Try again; any saved choice is preserved.");
    } catch { setError("Could not confirm the destination. Try again; any saved choice is preserved."); }
    finally { lock.current = false; setBusy(false); }
  };
  return <div className="mt-1 text-sm">
    <button type="button" onClick={choose} disabled={busy} className="min-h-11 rounded px-1 text-muted underline underline-offset-4 hover:text-foreground disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-brand">{busy ? "Choosing Aryeo…" : "Upload to Aryeo instead?"}</button>
    {error && <p role="alert" className="mt-1 break-words text-danger">{error}</p>}
  </div>;
}
