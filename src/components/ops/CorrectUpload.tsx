"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { correctVideoUploadAction } from "@/app/ops/actions";
import { Button } from "@/components/ui/Action";
import { SaveStatus } from "@/components/ui/SaveStatus";
export function CorrectUpload({ submissionId, receiptId }: { submissionId: string; receiptId: string }) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, start] = useTransition();
  const router = useRouter();
  return <details className="mt-3"><summary className="min-h-11 cursor-pointer text-sm">Correct an upload marked by mistake</summary><form className="space-y-2" onSubmit={(event) => {
    event.preventDefault(); if (busy || !reason.trim()) return;
    start(async () => { try { const r = await correctVideoUploadAction(submissionId, receiptId, reason); setResult(r); if (r.ok) router.refresh(); } catch { setResult({ ok: false, message: "Correction status is unconfirmed. Refresh this video before trying again." }); } });
  }}><label className="block text-sm">Reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} className="mt-1 block w-full rounded-lg border border-border bg-surface p-2" /></label><Button type="submit" variant="secondary" busy={busy}>Correct upload status</Button>{result && <SaveStatus state={result.ok ? "saved" : "error"} message={result.message} />}</form></details>;
}
