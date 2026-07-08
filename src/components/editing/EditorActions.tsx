"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { sendEditToReview } from "@/app/editing/actions";

// The editor's primary "Done — send to review" button. Completes their
// edit_video task + flips the job to Review server-side, then the page
// revalidates so the card drops out of Do-Now. Optimistic disable while pending.
export function SendToReviewButton({ projectId }: { projectId: string }) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending || done}
        onClick={() =>
          start(async () => {
            try {
              await sendEditToReview(projectId);
              setDone(true);
            } catch (e) {
              setErr(e instanceof Error ? e.message : "Couldn't send — try again.");
            }
          })
        }
        className="inline-flex items-center gap-1.5 rounded-lg bg-[#5b53ff] px-3 py-1.5 text-sm font-semibold text-white hover:bg-[#4a43e0] disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        {done ? "Sent for review" : "Done — send to review"}
      </button>
      {err && <span className="text-xs text-danger">{err}</span>}
    </div>
  );
}
