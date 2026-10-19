"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Loader2 } from "lucide-react";
import { confirmJobRequests } from "@/app/jobs/actions";
import type { JobMedium } from "@/lib/jobChecks";

// The one "Checked" on a job's open client requests (Oct 19 2026). One press
// confirms every request the box lists, with who pressed it.
export function CheckedButton({ projectId, medium, count, compact }: { projectId: string; medium: JobMedium; count: number; compact?: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  const thing = medium === "photo" ? "the photos" : "the video";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        data-job-checked
        title={`I checked ${count === 1 ? "this request" : `these ${count} requests`} on ${thing}`}
        onClick={() =>
          start(async () => {
            const r = await confirmJobRequests(projectId, medium).catch(() => ({ ok: false, message: "That didn't go through. Reload the page and try again." }));
            setMsg(r);
            if (r.ok) router.refresh();
          })
        }
        className={`inline-flex items-center gap-1.5 rounded-xl bg-brand-action font-semibold text-brand-fg hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50 ${compact ? "min-h-9 px-2.5 text-xs" : "min-h-11 px-3 text-sm sm:min-h-9"}`}
      >
        {busy ? <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <CheckCheck aria-hidden className="size-4" />}
        Checked
      </button>
      {msg && (
        <span role="status" className={`text-[12px] ${msg.ok ? "text-success" : "text-danger"}`}>
          {msg.message}
        </span>
      )}
    </div>
  );
}
