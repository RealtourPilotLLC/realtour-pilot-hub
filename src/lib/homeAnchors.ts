// Links into the day's screens that were minted before Oct 19 2026 (Slack
// lines, bells, delivery receipts, other screens: "/#video-review",
// "/ops#loops", "/?test=1#comms-1") keep landing somewhere sensible. A plain
// module (no "use client"), so the Home page (a server component) and the
// client-side forwarder read the same lists.
//
// Oct 19 2026, evening: the daily checklist came back to Kyle's Home as ONE
// simplified list in five groups. Every old time-block id is now an anchor
// inside the group that holds that work (GROUP_ALIASES), so "/#loops" lands on
// Follow-ups due. /ops keeps today's shoot cards, stuck jobs and the
// exceptions (OPS_ANCHORS); an old block anchor that arrives at /ops is sent
// back to Home's group.

/** Old block ids, by the checklist group (on Kyle's Home) that holds their work now. */
export const GROUP_ALIASES: Record<string, readonly string[]> = {
  checklist: ["tower", "operating-routine"],
  deliveries: ["qc-am", "video-review", "pipeline", "monthly"],
  messages: ["comms-1"],
  scheduling: ["prep"],
  followups: ["loops"],
  earlier: ["overdue", "old-items"],
  "still-open": ["closeout"],
};

/** Anchors that live on /ops (today's shoot cards, stuck jobs, exceptions). */
export const OPS_ANCHORS = ["shoots", "stuck", "exceptions"] as const;

const OLD_BLOCKS = Object.values(GROUP_ALIASES).flat();
const isOldBlock = (id: string) => OLD_BLOCKS.includes(id);
const isOpsAnchor = (id: string) => (OPS_ANCHORS as readonly string[]).includes(id);

/** Where a URL with a moved anchor should go, or null when it stays put:
 *  "/#stuck" → "/ops#stuck"; "/ops?test=1#loops" → "/?test=1#loops" (Home's
 *  Follow-ups group carries the "loops" anchor). */
export function forwardedHref(pathname: string, search: string, hash: string): string | null {
  let id: string;
  try { id = decodeURIComponent(hash.replace(/^#/, "")); } catch { return null; }
  if (!id) return null;
  if (pathname === "/" && isOpsAnchor(id)) return `/ops${search}${hash}`;
  if (pathname === "/ops" && isOldBlock(id)) return `/${search}${hash}`;
  return null;
}

// For a link rendered on a screen WITHOUT the checklist (the review seat's
// Home): where each old block's work lives now, as a real screen.
const BLOCK_SCREEN: Record<string, string> = {
  tower: "/ops#shoots",
  "operating-routine": "/ops#shoots",
  shoots: "/ops#shoots",
  "qc-am": "/review",
  overdue: "/review",
  "video-review": "/review",
  "comms-1": "/ops/messages",
  prep: "/schedule",
  loops: "/tasks?tab=work",
  pipeline: "/pipeline",
  monthly: "/content",
  closeout: "/ops#shoots",
  stuck: "/ops#stuck",
  exceptions: "/ops#exceptions",
};

/** "#loops" → "/tasks?tab=work"; anything else unchanged. For links a Home
 *  without the checklist renders. */
export function blockScreen(href: string): string {
  return href.startsWith("#") ? BLOCK_SCREEN[href.slice(1)] ?? href : href;
}
