"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { setJobRequestMedium } from "@/app/jobs/actions";

// "Needs an owner" (Oct 19 2026): a request whose medium is unclear after the
// shoot. One press says what it is about; the owner follows (photos → Kyle,
// video → the job's editor, both → each on their own card).
const CHOICES = [
  { medium: "photo", label: "Photos" },
  { medium: "video", label: "Video" },
  { medium: "both", label: "Both" },
] as const;

export function RequestOwnerPicker({ askId }: { askId: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-owner-picker={askId}>
      <span className="text-xs text-muted">About:</span>
      {CHOICES.map((c) => (
        <button
          key={c.medium}
          type="button"
          disabled={busy}
          onClick={() =>
            start(async () => {
              const r = await setJobRequestMedium(askId, c.medium).catch(() => ({ ok: false, message: "That didn't go through. Reload the page and try again." }));
              setMsg(r);
              if (r.ok) router.refresh();
            })
          }
          className="inline-flex min-h-9 items-center rounded-lg border border-border px-2.5 text-xs font-medium text-foreground hover:bg-surface-2 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {c.label}
        </button>
      ))}
      {busy && <Loader2 aria-hidden className="size-3.5 animate-spin text-muted motion-reduce:animate-none" />}
      {msg && (
        <span role="status" className={`text-[12px] ${msg.ok ? "text-success" : "text-danger"}`}>
          {msg.message}
        </span>
      )}
    </div>
  );
}
