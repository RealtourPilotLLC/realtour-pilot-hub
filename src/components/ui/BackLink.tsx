"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

// The back control at the top of a page: ALWAYS goes to the screen it names
// (Jordan, Oct 12 2026: "When I hit the back button on the content program, I
// want it to take me back to the main content program screen. Same for any
// other back buttons on the hub … instead of backing up to my last page").
// It used to replay browser history whenever the user had moved around inside
// the app (the `rtp_nav` counter the Shell bumps), so "← Content Program" could
// land on the previous tab or client instead. The browser's own Back button
// still does that; this one goes up to its section. Client-side navigation for
// speed, with a real anchor so middle/cmd-click and no-JS still work.
//
// `preferHref` is kept for existing callers; it is now what every BackLink does.
export function BackLink({ href, label, className }: { href: string; label: string; className?: string; preferHref?: boolean }) {
  const router = useRouter();
  return (
    <a
      href={href}
      onClick={(e) => {
        // Let the browser handle modified clicks (open in new tab, etc.).
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        router.push(href);
      }}
      className={cn("inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-md px-1 py-2 text-sm text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand", className)}
    >
      <ArrowLeft className="size-4 shrink-0" /> <span className="min-w-0 break-words">{label}</span>
    </a>
  );
}
