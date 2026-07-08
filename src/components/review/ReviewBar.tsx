"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Loader2, Pencil, RefreshCw, Send } from "lucide-react";
import { sendReviewToLane } from "@/app/projects/reviewActions";

// Rollup strip above the media grid: live lane counts + the two "send"
// handoffs (EDIT → one deduped 24h task for Kyle; PHOTOGRAPHER → task + bell
// for whoever shot it). Counts arrive from MediaGallery's optimistic note
// state so they move the instant a note is added or fixed, before the server
// round-trip lands.
export function ReviewBar({
  projectId,
  editOpen,
  photogOpen,
  fixed,
}: {
  projectId: string;
  editOpen: number;
  photogOpen: number;
  fixed: number;
}) {
  const router = useRouter();
  const [pending, startPending] = useTransition();
  const [sending, setSending] = useState<"EDIT" | "PHOTOGRAPHER" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  function send(lane: "EDIT" | "PHOTOGRAPHER") {
    setSending(lane);
    setMsg(null);
    startPending(async () => {
      const r = await sendReviewToLane(projectId, lane);
      setMsg(r.message);
      setSending(null);
      router.refresh(); // pull fresh notes + the task/bell side effects
    });
  }

  return (
    <div className="mb-4 rounded-xl border border-brand/25 bg-brand-soft px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium">
          <Pencil className="size-3.5 text-brand" /> {editOpen} Kyle fix{editOpen === 1 ? "" : "es"} open
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium">
          <Camera className="size-3.5 text-sky-400" /> {photogOpen} photographer note{photogOpen === 1 ? "" : "s"}
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
          <RefreshCw className="size-3.5 text-success" /> {fixed} fixed awaiting re-review
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => send("EDIT")}
            disabled={editOpen === 0 || pending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {pending && sending === "EDIT" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            Send to Kyle ({editOpen})
          </button>
          <button
            onClick={() => send("PHOTOGRAPHER")}
            disabled={photogOpen === 0 || pending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
          >
            {pending && sending === "PHOTOGRAPHER" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
            Send to photographer ({photogOpen})
          </button>
        </div>
      </div>
      {msg && <p className="mt-1.5 text-xs text-muted">{msg}</p>}
    </div>
  );
}
