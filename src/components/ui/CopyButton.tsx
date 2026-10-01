"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

// A clipboard receipt belongs to the exact value that was copied.
export function CopyButton({
  value,
  title = "Copy",
  className,
  label,
}: {
  value: string;
  title?: string;
  className?: string;
  label?: string;
}) {
  const [receipt, setReceipt] = useState<{ value: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; if (timer.current) clearTimeout(timer.current); };
  }, []);
  const currentReceipt = receipt?.value === value ? receipt : null;
  const copied = currentReceipt?.ok === true;
  const failed = currentReceipt?.ok === false;
  const copyLabel = label || title;
  const status = copied ? "Copied" : failed ? "Copy failed. Select and copy the text manually, or try again." : "";
  return (
    <button
      type="button"
      title={failed ? status : title}
      aria-label={busy ? "Copying…" : copied ? "Copied" : failed ? `Copy failed. ${copyLabel}` : copyLabel}
      aria-busy={busy}
      disabled={busy}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (busyRef.current) return;
        busyRef.current = true; setBusy(true); setReceipt(null);
        if (timer.current) clearTimeout(timer.current);
        const requestedValue = value;
        try {
          if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
          await navigator.clipboard.writeText(requestedValue);
          if (mounted.current) {
            setReceipt({ value: requestedValue, ok: true });
            timer.current = setTimeout(() => { if (mounted.current) setReceipt(null); }, 1500);
          }
        } catch {
          if (mounted.current) setReceipt({ value: requestedValue, ok: false });
        } finally {
          busyRef.current = false;
          if (mounted.current) setBusy(false);
        }
      }}
      className={cn(
        "inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md p-2 text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50",
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      {(label || failed) && <span className="text-[13px]">{busy ? "Copying…" : copied ? "Copied" : failed ? "Copy failed" : label}</span>}
      <span className="sr-only" role="status" aria-live="polite">{status}</span>
    </button>
  );
}
