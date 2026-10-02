"use client";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { correctVideoSentAction } from "@/app/ops/actions";
import { Button } from "@/components/ui/Action";
import { SaveStatus } from "@/components/ui/SaveStatus";
export function CorrectSent({ submissionId, sentAt }: { submissionId: string; sentAt: string }) {
  const [reason, setReason] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, start] = useTransition();
  const pending = useRef(false);
  const router = useRouter();
  return <details><summary className="flex min-h-11 cursor-pointer items-center text-sm text-muted">Correct a mistaken delivery status</summary><form className="space-y-2" onSubmit={(event) => {
    event.preventDefault(); if (pending.current || !reason.trim()) return; pending.current = true;
    start(async () => { try { const r = await correctVideoSentAction(submissionId, sentAt, reason); setResult(r); if (r.ok) router.refresh(); } catch { setResult({ ok: false, message: "Correction is unconfirmed. Refresh this exact version before reconciling; no provider action was requested." }); } finally { pending.current = false; } });
  }}><label className="block text-sm">Reason<textarea value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={1000} className="mt-1 block w-full rounded-lg border border-border bg-surface p-2" /></label><Button type="submit" variant="secondary" busy={busy}>Correct hub status</Button>{result && <SaveStatus state={result.ok ? "saved" : "error"} message={result.message} />}</form></details>;
}
