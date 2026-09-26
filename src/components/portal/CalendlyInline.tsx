"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

// ---------------------------------------------------------------------------
// CALENDLY, INSIDE THE PORTAL (W03, Sep 25 2026). Calendly's documented inline
// embed is an iframe of the scheduling page with `embed_domain` and
// `embed_type=Inline`; the page then posts `calendly.*` messages to its parent.
// The iframe is built here directly rather than through widget.js — one less
// third-party script on a client's page, and the same messages.
//
// A message is believed only if it comes from https://calendly.com AND from
// THIS iframe. Even then it is a hint, not a fact: `onScheduled` gets the event
// URI, and the server re-reads that event from Calendly before filing it.
// ---------------------------------------------------------------------------

const CALENDLY_ORIGIN = "https://calendly.com";
const noSubscribe = () => () => {};

/** The page with Calendly's embed parameters, or null (not a calendly.com page, or not in a browser yet). */
function embedSrc(url: string, host: string | null): string | null {
  if (!host) return null;
  try {
    const u = new URL(url);
    if (u.origin !== CALENDLY_ORIGIN) return null;
    u.searchParams.set("embed_domain", host);
    u.searchParams.set("embed_type", "Inline");
    u.searchParams.set("hide_gdpr_banner", "1");
    return u.toString();
  } catch {
    return null;
  }
}

export type CalendlyScheduled = { eventUri: string; inviteeUri: string | null };

type CalendlyMessage = {
  event?: unknown;
  payload?: { height?: unknown; event?: { uri?: unknown }; invitee?: { uri?: unknown } };
};

export function CalendlyInline({ url, fallbackUrl, title = "Book your strategy call", onScheduled }: {
  /** The scheduling (or reschedule / cancel) page, prefilled. */
  url: string;
  /** Where "open it in a new tab" goes; the page itself when omitted. */
  fallbackUrl?: string | null;
  title?: string;
  onScheduled?: (s: CalendlyScheduled) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  // embed_domain is where the page is served from — known only in the browser
  // (null on the server render, so the iframe mounts after hydration).
  const host = useSyncExternalStore(noSubscribe, () => window.location.host, () => null);
  const src = useMemo(() => embedSrc(url, host), [url, host]);
  const [height, setHeight] = useState(700);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const loaded = !!src && loadedSrc === src;
  const seen = useRef(new Set<string>());
  const cb = useRef(onScheduled);
  useEffect(() => { cb.current = onScheduled; }, [onScheduled]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== CALENDLY_ORIGIN) return;
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as CalendlyMessage | null;
      if (!d || typeof d.event !== "string" || !d.event.startsWith("calendly.")) return;
      if (d.event === "calendly.page_height") {
        const h = parseInt(String(d.payload?.height ?? ""), 10);
        if (h >= 400 && h <= 2400) setHeight(h);
      } else if (d.event === "calendly.event_scheduled") {
        const eventUri = typeof d.payload?.event?.uri === "string" ? d.payload.event.uri : null;
        if (!eventUri || seen.current.has(eventUri)) return; // the widget can say it twice
        seen.current.add(eventUri);
        cb.current?.({ eventUri, inviteeUri: typeof d.payload?.invitee?.uri === "string" ? d.payload.invitee.uri : null });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const outside = fallbackUrl ?? url;
  return (
    <div className="space-y-1.5">
      <div className="relative overflow-hidden rounded-xl border border-border bg-white">
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-xs text-muted" aria-hidden>
            <Loader2 className="size-4 animate-spin" /> Loading the calendar…
          </div>
        )}
        {src && <iframe key={src} ref={frame} src={src} title={title} onLoad={() => setLoadedSrc(src)} className="relative block w-full" style={{ height, minWidth: 0 }} />}
      </div>
      <a href={outside} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1 text-xs text-muted hover:text-foreground hover:underline sm:min-h-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
        Calendar not loading? Open it in a new tab <ExternalLink className="size-3" aria-hidden />
      </a>
    </div>
  );
}
