// The daily checklist moved off Home onto /ops on Oct 19 2026, block ids and
// all. These are the anchors that now live there. A plain module (no "use
// client"), so the Home page (a server component) and the client-side
// forwarder read the same list.
export const MOVED_ANCHORS = [
  "tower", "qc-am", "overdue", "comms-1", "prep", "loops", "video-review", "pipeline", "monthly", "closeout",
  "shoots", "stuck", "exceptions", "operating-routine",
] as const;

const isMoved = (id: string) => (MOVED_ANCHORS as readonly string[]).includes(id);

/** "#loops" → "/ops#loops"; anything else unchanged. For links Home renders. */
export function opsAnchor(href: string): string {
  return href.startsWith("#") && isMoved(href.slice(1)) ? `/ops${href}` : href;
}

/** Where a Home URL with a moved anchor should go ("/?test=1#loops" →
 *  "/ops?test=1#loops"), or null when it stays on Home. */
export function forwardedHref(pathname: string, search: string, hash: string): string | null {
  if (pathname !== "/") return null;
  let id: string;
  try { id = decodeURIComponent(hash.replace(/^#/, "")); } catch { return null; }
  return isMoved(id) ? `/ops${search}${hash}` : null;
}
