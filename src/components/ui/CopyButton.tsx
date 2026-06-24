"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

// Small copy-to-clipboard button. Shows a check for ~1.5s after copying.
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
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
      className={cn(
        "inline-flex items-center gap-1 text-muted transition-colors hover:text-foreground",
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      {label && <span className="text-xs">{copied ? "Copied" : label}</span>}
    </button>
  );
}
