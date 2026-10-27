"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attachUnlinkedSessionToMonth } from "@/app/content/actions";

// Oct 27 2026 (Jordan: "Repair a missing session link ... I don't think that
// should be in production ... in sessions, I guess"): it now sits folded at
// the foot of the Filming sessions list it repairs, worded as the question a
// person has ("A session is missing?"), not as its own card under it.

export function UnlinkedSessionLinker({
  monthId, monthKey, monthName, jobs,
}: {
  monthId: string;
  monthKey: string;
  /** "October" — the words on the button; the key stays for the action. */
  monthName?: string;
  jobs: { id: string; title: string; date: string | null }[];
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState("");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  if (jobs.length === 0) return null;
  const label = monthName ?? monthKey;
  return (
    <details className="group border-t border-border px-5 py-3 text-sm">
      <summary className="cursor-pointer text-[13px] text-muted hover:text-foreground">A session is missing? Link one of their video jobs to {label}</summary>
      <p className="mt-2 text-xs text-muted">These are this client&apos;s recent video jobs with no content month. Confirm the appointment and package before linking one to {label}. Files and video identities stay on their own jobs.</p>
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
        })} className="rounded-lg bg-brand-action px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy ? "Linking…" : `Link to ${label}`}</button>
      </div>
      {notice && <p role="status" className={`mt-2 text-xs ${notice.ok ? "text-success" : "text-danger"}`}>{notice.text}</p>}
      {jobs.length === 25 && <p className="mt-2 text-xs text-muted">Showing the most recent 25 unlinked video jobs.</p>}
    </details>
  );
}
