// ---------------------------------------------------------------------------
// MESSAGES: ONE INBOX (Oct 19 2026). Jordan approved: "Messages merges
// Communications and Client messages into one inbox", and the priority is
// "responding to clients quickly". /communications is that inbox. Its first
// view is "Waiting on us" (what /ops/messages showed: every client waiting on
// a reply, texts and email together, oldest first, and new leads). The other
// views follow, in this order, each with its own number on the tab and
// nowhere else on the page.
//
// ONE QUEUE (Jordan, Oct 27 2026: "One queue + Gmail draft"). Waiting on us is
// the only list of things to answer. The Texts tab, a second list of the same
// waiting texts, is off the tab bar: the texts only it listed (numbers we have
// not saved, our own team, thank-yous) are on Waiting on us now, and "texts"
// lives on only as the screen a text's Reply opens (?tab=texts&focus=<key>:
// that one conversation, a reply ready to write). Email, Team, Outbox and All
// browse conversations; none of them is a second to-do list.
//
// Plain module (no server-only imports) so the tab rules can be checked on
// their own.
// ---------------------------------------------------------------------------

/** "texts" is a view (one text conversation's reply screen), not a tab. */
export type MessagesTab = "waiting" | "texts" | "email" | "team" | "outbox" | "all";

export const MESSAGES_TABS: { key: Exclude<MessagesTab, "texts">; label: string; title: string }[] = [
  { key: "waiting", label: "Waiting on us", title: "Everything waiting on a reply: clients, unsaved numbers and new leads" },
  { key: "email", label: "Email", title: "Client email from the last 60 days, to read and answer" },
  { key: "team", label: "Team", title: "Team messages by property" },
  { key: "outbox", label: "Outbox", title: "Confirmation and delivery texts ready to check and send" },
  { key: "all", label: "All", title: "Every text and call conversation, live from OpenPhone" },
];

/** Old tab names keep landing on the same work: the OpenPhone list was the
 *  page's "Inbox". ?tab=replies (and ?tab=texts) was the text reply queue; it
 *  opens Waiting on us now, or that one conversation when a focus names it. */
const ALIASES: Record<string, MessagesTab> = { inbox: "all" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export function resolveMessagesTab(sp: { tab?: string | string[]; incident?: string | string[]; focus?: string | string[] }): MessagesTab {
  const raw = (one(sp.tab) ?? "").trim().toLowerCase();
  if (raw === "texts" || raw === "replies") return (one(sp.focus) ?? "").trim() ? "texts" : "waiting";
  const named = MESSAGES_TABS.find((t) => t.key === raw);
  if (named) return named.key;
  if (raw in ALIASES) return ALIASES[raw];
  // A delivery-text check (?incident=, from the delivery cards) is matched
  // against the live conversations, so it opens on All, as it always did.
  if (one(sp.incident)) return "all";
  return "waiting";
}

/** The tab a view sits under on the tab bar: a text's reply screen is part of
 *  Waiting on us. */
export function tabBarKey(tab: MessagesTab): Exclude<MessagesTab, "texts"> {
  return tab === "texts" ? "waiting" : tab;
}

/** The views that read ?test=1 (real and test records together). Texts joined
 *  them Oct 20 2026 (audit F24): it listed and counted test clients. */
export const TEST_SCOPED_TABS: ReadonlySet<MessagesTab> = new Set<MessagesTab>(["waiting", "texts", "email", "outbox"]);

export function messagesHref(tab: MessagesTab, opts: { test?: boolean; focus?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (tab !== "waiting") q.set("tab", tab);
  if (opts.focus) q.set("focus", opts.focus);
  if (opts.test && TEST_SCOPED_TABS.has(tab)) q.set("test", "1");
  const s = q.toString();
  return s ? `/communications?${s}` : "/communications";
}

/** A waiting row's Reply, on this page: a text opens that conversation's reply
 *  screen; an email opens the Email view with that thread open and its reply
 *  box ready (Oct 27 2026: email is answered in the hub too). Both keep the
 *  test view, so a test client's Reply finds its conversation. */
export function waitingReplyHref(family: "phone" | "email", focus: string, test = false): string {
  return messagesHref(family === "email" ? "email" : "texts", { focus, test });
}
