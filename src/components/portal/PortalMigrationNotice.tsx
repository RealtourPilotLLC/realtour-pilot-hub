"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { Info, MessageSquare } from "lucide-react";
import { PORTAL_MIGRATION_NOTICE as N } from "@/lib/portalNotice";
import { cn } from "@/lib/utils";

// The calm "still moving things over" notice (Jordan, Oct 6 2026; words and
// the on/off in lib/portalNotice.ts). Soft info, not an alert: no red, no
// amber. "Got it" is remembered per browser in localStorage — every read and
// write wrapped, because storage can be blocked (private windows, previews),
// and then the notice simply stays. The server render always shows it, so a
// page without script still says it; a dismissed browser hides it on load.

const EVENT = "rtp-portal-notice";
const readDismissed = (): boolean => {
  try { return window.localStorage.getItem(N.id) === "1"; } catch { return false; }
};
const subscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  window.addEventListener(EVENT, cb);
  return () => { window.removeEventListener("storage", cb); window.removeEventListener(EVENT, cb); };
};

const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

export function PortalMigrationNotice({ tellUsHref }: { tellUsHref: string }) {
  const dismissed = useSyncExternalStore(subscribe, readDismissed, () => false);
  if (dismissed) return null;
  const dismiss = () => {
    try { window.localStorage.setItem(N.id, "1"); } catch { /* storage blocked: it stays, which is harmless */ }
    window.dispatchEvent(new Event(EVENT));
  };
  return (
    <section data-portal-notice="migration" aria-labelledby="portal-notice-title" className="mt-5 flex flex-wrap items-start gap-2 rounded-2xl border border-border bg-surface/80 p-3.5 text-sm">
      <Info className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
      <div className="min-w-0 flex-1 basis-56">
        <h2 id="portal-notice-title" className="font-semibold">{N.title}</h2>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{N.body}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Link href={tellUsHref} className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-brand/30 bg-surface px-3 text-xs font-semibold text-brand hover:bg-surface-2", focus)}>
            <MessageSquare className="size-3.5" aria-hidden /> {N.cta}
          </Link>
          <button type="button" onClick={dismiss} className={cn("inline-flex min-h-11 items-center rounded-lg px-3 text-xs font-medium text-muted hover:text-foreground", focus)}>
            {N.dismiss}
          </button>
        </div>
      </div>
    </section>
  );
}
