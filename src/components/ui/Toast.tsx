"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// A pop-up confirmation for an action that answers at once and finishes in the
// background (Oct 12 2026: "Sent for scripting — …"). Bottom-centre, above the
// mobile tab bar, dismissable, gone after a few seconds. The live region is
// always mounted so a screen reader announces each new message.
// ---------------------------------------------------------------------------

type ToastMsg = { kind: "ok" | "err"; text: string; n: number };

export function useToast(ms = 6000): { toast: ReactNode; show: (kind: "ok" | "err", text: string) => void } {
  const [msg, setMsg] = useState<ToastMsg | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((kind: "ok" | "err", text: string) => {
    setMsg((cur) => ({ kind, text, n: (cur?.n ?? 0) + 1 }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), kind === "err" ? ms + 3000 : ms);
  }, [ms]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const toast = (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[1400] flex justify-center px-4 sm:bottom-6">
      {msg && (
        <div key={msg.n} className={cn(
          "pointer-events-auto flex max-w-md items-start gap-2 rounded-xl px-4 py-2.5 text-sm font-medium shadow-lg ring-1",
          msg.kind === "ok" ? "bg-foreground text-background ring-border-strong" : "bg-danger-action text-white ring-danger/30",
        )}>
          <span className="min-w-0 flex-1">{msg.text}</span>
          <button type="button" onClick={() => setMsg(null)} aria-label="Dismiss" className="-mr-1 shrink-0 rounded p-0.5 opacity-80 hover:opacity-100"><X className="size-4" /></button>
        </div>
      )}
    </div>
  );
  return { toast, show };
}
