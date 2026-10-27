"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, Check, Loader2, UserX } from "lucide-react";
import { dismissUnsavedNumber } from "@/app/communications/messageActions";

// A TEXT FROM A NUMBER WE HAVE NOT SAVED (Jordan, Oct 27 2026 Loom, 40:12:
// "Kyle needs to be able to dismiss this"): two one-press answers, Not a
// client and Spam. Both clear the row and mute the number with that reason;
// the muted-numbers fold under the list undoes either. A teammate's number is
// refused (their texts are how the field talks to the office).
export function UnsavedNumberActions({ threadKey }: { threadKey: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (done) return <span className="text-xs font-medium text-muted"><Check aria-hidden className="mr-1 inline size-3.5" />{done}</span>;
  const pick = (reason: "not a client" | "spam") =>
    start(async () => {
      setErr(null);
      const r = await dismissUnsavedNumber(threadKey, reason).catch(() => ({ ok: false, message: "Could not save. Try again." }));
      if (r.ok) {
        setDone(r.message ?? "Done");
        router.refresh();
      } else setErr(r.message ?? "Could not save. Try again.");
    });
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() => pick("not a client")}
        title="Not someone we work for: clear it and mute the number"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
      >
        <UserX aria-hidden className="size-4" /> Not a client
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => pick("spam")}
        title="Spam: clear it and mute the number"
        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
      >
        <Ban aria-hidden className="size-4" /> Spam
      </button>
      {busy && <Loader2 aria-hidden className="size-4 animate-spin text-muted" />}
      {err && <span className="basis-full text-xs text-danger">{err}</span>}
    </div>
  );
}
