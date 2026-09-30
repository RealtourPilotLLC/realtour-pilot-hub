"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attachUnlinkedSessionToMonth } from "@/app/content/actions";

export function UnlinkedSessionLinker({
  monthId, monthKey, jobs,
}: {
  monthId: string;
  monthKey: string;
  jobs: { id: string; title: string; date: string | null }[];
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState("");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  if (jobs.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-surface p-4 text-sm">
      <h3 className="font-semibold">Repair a missing session link</h3>
      <p className="mt-1 text-xs text-muted">These are this client&apos;s recent video jobs with no content month. Confirm the appointment and package before linking one to {monthKey}. Files and video identities stay on their own jobs.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
        <label className="text-xs font-medium">Unlinked job
          <select value={projectId} onChange={(e) => { setProjectId(e.target.value); setNotice(null); }} disabled={busy} className="mt-1 block w-full rounded-lg border border-border bg-surface-2 px-2 py-2 text-sm">
            <option value="">Choose a job</option>
            {jobs.map((j) => <option key={j.id} value={j.id}>{j.title}{j.date ? ` · ${j.date}` : " · no date"}</option>)}
          </select>
        </label>
        <label className="text-xs font-medium">Why it belongs to this month
          <input value={reason} onChange={(e) => { setReason(e.target.value); setNotice(null); }} maxLength={500} disabled={busy} placeholder="Appointment or package evidence" className="mt-1 block w-full rounded-lg border border-border bg-surface-2 px-2 py-2 text-sm" />
        </label>
        <button type="button" disabled={busy || !projectId || reason.trim().length < 8} onClick={() => start(async () => {
          const result = await attachUnlinkedSessionToMonth(projectId, monthId, reason).catch(() => ({ ok: false, message: "The link could not be saved. Try again." }));
          setNotice({ ok: result.ok, text: result.message });
          if (result.ok) { setProjectId(""); setReason(""); router.refresh(); }
        })} className="rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy ? "Linking…" : `Link to ${monthKey}`}</button>
      </div>
      {notice && <p role="status" className={`mt-2 text-xs ${notice.ok ? "text-success" : "text-danger"}`}>{notice.text}</p>}
      {jobs.length === 25 && <p className="mt-2 text-xs text-muted">Showing the most recent 25 unlinked video jobs.</p>}
    </div>
  );
}
