"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Undo2, Loader2 } from "lucide-react";
import { restoreToAr } from "@/app/billing/actions";

/** Undo a removal — puts the job back on the unpaid list. */
export function RestoreToAr({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  return (
    <button
      disabled={busy}
      onClick={() => start(async () => { await restoreToAr(projectId).catch(() => {}); router.refresh(); })}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Undo2 className="size-3" />} Put back
    </button>
  );
}
