// ---------------------------------------------------------------------------
// MESSAGES: ONE INBOX (Oct 19 2026). Jordan approved: "Messages merges
// Communications and Client messages into one inbox", and the priority is
// "responding to clients quickly". /communications is that inbox. Its first
// view is "Waiting on us" (what /ops/messages showed: every client waiting on
// a reply, texts and email together, oldest first, and new leads). The other
// views follow, in this order, each with its own number on the tab and
// nowhere else on the page.
//
// Plain module (no server-only imports) so the tab rules can be checked on
// their own.
// ---------------------------------------------------------------------------

export type MessagesTab = "waiting" | "texts" | "email" | "team" | "outbox" | "all";

export const MESSAGES_TABS: { key: MessagesTab; label: string; title: string }[] = [
  { key: "waiting", label: "Waiting on us", title: "Clients waiting on a reply, and new leads" },
  { key: "texts", label: "Texts", title: "Every unanswered text, with a reply ready to write" },
  { key: "email", label: "Email", title: "Client email from the last 60 days" },
  { key: "team", label: "Team", title: "Team messages by property" },
  { key: "outbox", label: "Outbox", title: "Confirmation and delivery texts ready to check and send" },
  { key: "all", label: "All", title: "Every text and call conversation, live from OpenPhone" },
];

/** Old tab names keep landing on the same work: ?tab=replies was the text
 *  reply queue, and the OpenPhone list was the page's "Inbox". */
const ALIASES: Record<string, MessagesTab> = { replies: "texts", inbox: "all" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function resolveMessagesTab(sp: { tab?: string | string[]; incident?: string | string[] }): MessagesTab {
  const raw = (one(sp.tab) ?? "").trim().toLowerCase();
  const named = MESSAGES_TABS.find((t) => t.key === raw);
  if (named) return named.key;
  if (raw in ALIASES) return ALIASES[raw];
  // A delivery-text check (?incident=, from the delivery cards) is matched
  // against the live conversations, so it opens on All, as it always did.
  if (one(sp.incident)) return "all";
  return "waiting";
}

/** The views that read ?test=1 (real and test records together). */
export const TEST_SCOPED_TABS: ReadonlySet<MessagesTab> = new Set<MessagesTab>(["waiting", "email", "outbox"]);

export function messagesHref(tab: MessagesTab, opts: { test?: boolean; focus?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (tab !== "waiting") q.set("tab", tab);
  if (opts.focus) q.set("focus", opts.focus);
  if (opts.test && TEST_SCOPED_TABS.has(tab)) q.set("test", "1");
  const s = q.toString();
  return s ? `/communications?${s}` : "/communications";
}

/** A waiting row's Reply, on this page: a text opens the Texts view with that
 *  conversation first and open; an email opens the Email view with that
 *  thread open (Gmail is still where an email reply is written). */
export function waitingReplyHref(family: "phone" | "email", focus: string, test = false): string {
  return family === "email" ? messagesHref("email", { focus, test }) : messagesHref("texts", { focus });
}
