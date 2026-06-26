"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

// A back control that returns the user to where they ACTUALLY came from when
// they navigated within the app (e.g. opened a shoot from the dashboard → back
// goes to the dashboard, not a fixed section). When the page was opened cold — a
// deep link from a text/email, a new tab — it falls back to a sensible section
// page instead of bouncing them out of the app. Renders a real anchor to that
// fallback so middle/cmd-click and no-JS still work.
//
// In-app navigation is detected via the `rtp_nav` counter the Shell bumps on
// every route change (Next 16's App Router doesn't expose a history index).
export function BackLink({ href, label, className }: { href: string; label: string; className?: string }) {
  const router = useRouter();
  return (
    <a
      href={href}
      onClick={(e) => {
        // Let the browser handle modified clicks (open in new tab, etc.).
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        let inApp = false;
        try {
          inApp = Number(sessionStorage.getItem("rtp_nav") || "0") > 1;
        } catch {
          /* sessionStorage blocked — use the fallback href */
        }
        if (inApp) {
          e.preventDefault();
          router.back();
        }
        // else: no in-app history — follow the href to the section page.
      }}
      className={cn("inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground", className)}
    >
      <ArrowLeft className="size-4" /> {label}
    </a>
  );
}
