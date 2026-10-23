"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { acknowledgePhotographerBrief } from "@/app/shoot/brief/actions";

// The photographer's "Got it" on their day's brief (Oct 23 2026,
// lib/photographerBrief). It acknowledges exactly the version on screen: the
// server refuses a digest that is no longer current.
export function BriefGotIt({ day, digest, again }: { day: string; digest: string; again: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="space-y-2">
      {msg && (
        <p role="status" className={`flex items-center gap-2 text-sm ${msg.ok ? "text-success" : "text-danger"}`}>
          {msg.ok && <CheckCircle2 className="size-4 shrink-0" />} {msg.text}
        </p>
      )}
      {!msg?.ok && (
        <button
          type="button"
          disabled={pending}
          className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-action px-5 py-3 text-base font-semibold text-white disabled:opacity-50 sm:w-auto"
          onClick={() =>
            start(async () => {
              try {
                const r = await acknowledgePhotographerBrief(day, digest);
                setMsg({ ok: r.ok, text: r.message });
                if (r.ok) router.refresh();
              } catch {
                setMsg({ ok: false, text: "Could not save that. Try again." });
              }
            })
          }
        >
          {pending && <Loader2 className="size-4 animate-spin" />}
          {again ? "Got it (the updated brief)" : "Got it"}
        </button>
      )}
    </div>
  );
}
