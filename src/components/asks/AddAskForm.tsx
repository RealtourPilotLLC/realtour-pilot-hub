"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";
import { addAskAction, type AskActionResult } from "@/app/ops/requests/actions";

// Add a client's special request by hand (Oct 19 2026): something said on a
// call, in person, or anywhere the hub did not read. It holds the job's
// delivery until it is confirmed, unless the box is unticked.
export function AddAskForm({ jobs }: { jobs: { id: string; label: string }[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [job, setJob] = useState("");
  const [text, setText] = useState("");
  const [medium, setMedium] = useState("unclear");
  const [holds, setHolds] = useState(true);
  const [msg, setMsg] = useState<AskActionResult | null>(null);
  return (
    <details className="panel-shadow rounded-2xl border bg-surface px-4 py-1">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold">
        <Plus aria-hidden className="size-4 text-brand" /> Add a request by hand
      </summary>
      <form
        className="space-y-2 border-t py-3"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await addAskAction({ projectId: job, text, medium, holdsDelivery: holds }).catch(() => ({ ok: false, message: "That didn't go through. Try again." }));
            setMsg(r);
            if (r.ok) {
              setText("");
              router.refresh();
            }
          });
        }}
      >
        <label className="block text-[12px] font-medium text-muted" htmlFor="add-ask-job">Job</label>
        <select id="add-ask-job" value={job} onChange={(e) => setJob(e.target.value)} className="min-h-11 w-full rounded-lg border bg-surface-2 px-2 text-sm">
          <option value="">Pick the job</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>{j.label}</option>
          ))}
        </select>
        <label className="block text-[12px] font-medium text-muted" htmlFor="add-ask-text">What the client asked for</label>
        <textarea id="add-ask-text" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} className="w-full rounded-lg border bg-surface-2 p-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40" />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-sm">
            <span className="text-muted">About</span>
            <select value={medium} onChange={(e) => setMedium(e.target.value)} className="min-h-11 rounded-lg border bg-surface-2 px-2 text-sm sm:min-h-9">
              <option value="unclear">Photos or video</option>
              <option value="photo">Photos</option>
              <option value="video">Video</option>
              <option value="both">Photos and video</option>
            </select>
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm sm:min-h-9">
            <input type="checkbox" checked={holds} onChange={(e) => setHolds(e.target.checked)} className="size-4" />
            Hold delivery until it is confirmed
          </label>
        </div>
        <button type="submit" disabled={busy || !job || text.trim().length < 3} className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand-action px-3.5 text-sm font-semibold text-brand-fg hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <Plus aria-hidden className="size-4" />} Add
        </button>
        {msg && <p role="status" className={`text-[12px] ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}
      </form>
    </details>
  );
}
