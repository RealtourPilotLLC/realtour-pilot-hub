"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2 } from "lucide-react";
import { acknowledgeUploadProcess } from "@/app/upload/actions";

export function AgreeButton({ next = "/upload" }: { next?: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-3">
      <button
        disabled={busy}
        onClick={() =>
          start(async () => {
            const r = await acknowledgeUploadProcess().catch(() => ({ ok: false }));
            if (r.ok) router.push(next);
            else setErr("Couldn't save — make sure you're signed in, then try again.");
          })
        }
        className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        I agree — take me to my shoots
      </button>
      {err && <span className="text-[13px] text-danger">{err}</span>}
    </span>
  );
}
