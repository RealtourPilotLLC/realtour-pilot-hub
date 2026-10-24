// Links into the day's screens that were minted before Oct 19 2026 (Slack
// lines, bells, delivery receipts, other screens: "/#video-review",
// "/ops#loops", "/?test=1#comms-1") keep landing somewhere sensible. A plain
// module (no "use client"), so the server pages and the client-side forwarder
// read the same lists.
//
// Oct 19 2026, night (Jordan: "The home page should really be a dashboard to
// oversee everything going on"): "/" is the dashboard and Kyle's daily
// checklist is its own page (CHECKLIST_PATH, "Your list"). Every old
// time-block id is an anchor inside the checklist group that holds that work
// (GROUP_ALIASES), so "/#loops" is forwarded to the list's Follow-ups due.
// /ops ("Shoots and exceptions") redirects to the dashboard, which carries
// #shoots (Today's shoots) and #stuck / #exceptions (Needs attention now).

/** Kyle's daily checklist ("Your list" for an office login, "Kyle's list" for the owner). */
export const CHECKLIST_PATH = "/ops/checklist";

/** Old block ids, by the checklist group that holds their work now. */
export const GROUP_ALIASES: Record<string, readonly string[]> = {
  checklist: ["tower", "operating-routine"],
  deliveries: ["qc-am", "video-review", "pipeline", "monthly"],
  messages: ["comms-1"],
  scheduling: ["prep"],
  followups: ["loops"],
  earlier: ["overdue", "old-items"],
  "still-open": ["closeout"],
};

/** Every anchor the checklist page carries: its groups and the old block ids inside them. */
export const CHECKLIST_ANCHORS: readonly string[] = [
  ...Object.keys(GROUP_ALIASES), ...Object.values(GROUP_ALIASES).flat(),
  "requests", "done-today",
];

/** Old anchors about answering clients: Messages (/communications, "Waiting on us") holds that work. */
export const MESSAGES_ANCHORS = ["comms-1", "messages"] as const;

const isChecklistAnchor = (id: string) => CHECKLIST_ANCHORS.includes(id);
const isMessagesAnchor = (id: string) => (MESSAGES_ANCHORS as readonly string[]).includes(id);

/** Where a URL with a moved anchor should go, or null when it stays put:
 *  "/#loops" → "/ops/checklist#loops"; "/?test=1#requests" →
 *  "/ops/checklist?test=1#requests"; "/#comms-1" → Messages
 *  ("/communications", its Waiting on us view); "/#my-list" (the owner's
 *  to-dos, which left Home) → "/day". The dashboard's own anchors stay. */
export function forwardedHref(pathname: string, search: string, hash: string): string | null {
  let id: string;
  try { id = decodeURIComponent(hash.replace(/^#/, "")); } catch { return null; }
  if (!id || pathname !== "/") return null;
  if (isMessagesAnchor(id)) return `/communications${search}`;
  // The video queue (Oct 23 2026 audit): the Topaz bells and Slack lines
  // ("Topaz file held", "credits running low", "Listen to it on the delivery
  // queue") and a portal video's "Run Topaz on the delivery queue" still link
  // "/#video-review", which landed on the checklist's Deliveries group: no
  // held file to listen to, no Run Topaz, no hand path. Those live in Video
  // Delivery's Ready to send (its Held rows and its follow-up fold).
  if (id === "video-review") return `/review${search}#ready-to-send`;
  if (isChecklistAnchor(id)) return `${CHECKLIST_PATH}${search}${hash}`;
  if (id === "my-list") return "/day";
  return null;
}
