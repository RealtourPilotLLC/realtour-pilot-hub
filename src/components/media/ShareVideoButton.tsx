"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// SHARE (Jordan, Oct 27 2026: "a button to be able to share. Share the video,
// so like a link to share"). Copies the video's link in the client's portal
// (lib/mediaShareCore, decided on the server; never a Dropbox link) and says
// "Link copied". Where the clipboard is blocked, the link is offered to copy
// by hand. Nothing is sent to anyone.
// ---------------------------------------------------------------------------

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the older way */
  }
  try {
    const t = document.createElement("textarea");
    t.value = text;
    t.setAttribute("readonly", "");
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand("copy");
    t.remove();
    return ok;
  } catch {
    return false;
  }
}

export function ShareVideoButton({ href, title, className, compact = false }: { href: string; title: string; className?: string; compact?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const words = state === "copied" ? "Link copied" : "Share";
  return (
    <>
      <button
        type="button"
        data-share-video={href}
        title="Copy a link to this video in the client's portal"
        aria-label={state === "copied" ? `Link copied for ${title}` : `Share ${title}: copy its link in the client's portal`}
        onClick={async () => {
          if (timer.current) clearTimeout(timer.current);
          const ok = await copyText(href);
          setState(ok ? "copied" : "failed");
          if (ok) timer.current = setTimeout(() => setState("idle"), 2500);
          else window.prompt("Copy this link to the video in the client's portal", href);
        }}
        className={className}
      >
        {state === "copied" ? <Check aria-hidden className="size-4 text-success" /> : <Link2 aria-hidden className="size-4" />}
        <span className={cn(compact && "hidden @2xs:inline")}>{words}</span>
      </button>
      <span className="sr-only" role="status" aria-live="polite">{state === "copied" ? "Link copied" : state === "failed" ? "Could not copy the link. It is shown to copy by hand." : ""}</span>
    </>
  );
}
