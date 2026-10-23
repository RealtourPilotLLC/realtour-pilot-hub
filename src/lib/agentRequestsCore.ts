// ---------------------------------------------------------------------------
// THE AGENT'S REQUESTS, AT THE TOP OF THE UPLOAD PAGE (Oct 23 2026, Jordan's
// spec: "show existing agent requests prominently ... the source and let the
// photographer open the original. Keep current-visit requirements
// distinguishable from historical notes and unresolved conflicts. Never
// require retyping existing requests.").
//
// Pure and client-safe: the shapes the page draws and the one rule for
// "the same request twice". The reads are lib/agentRequests.
//
// The requests are the agent's (or the office's for them), never the
// photographer's handoff notes: those stay in their own editable boxes.
// ---------------------------------------------------------------------------

export type AgentRequestSource =
  /** the Aryeo order's special instructions / order notes */
  | "order_note"
  /** a client ask filed from their text, email or call (lib/clientAsks) */
  | "client_ask"
  /** a request the office typed on the job, or an ask staff filed for the client */
  | "office"
  /** a request the agent made at the shoot, logged here by the photographer */
  | "on_site"
  /** a client preference the office confirmed */
  | "preference"
  /** the client's standing customer note (Aryeo) */
  | "customer_note";

/** Which part of the card it sits in. */
export type AgentRequestGroup =
  /** asked for this job / this visit, still to do */
  | "visit"
  /** standing notes and preferences that apply to every job */
  | "standing"
  /** waiting on the office: a preference somebody reported that nobody has confirmed */
  | "unresolved"
  /** done, closed, or from an earlier visit: shown for context only */
  | "history";

export type AgentRequestItem = {
  id: string;
  /** the one line the card shows (money-scrubbed for a creative) */
  text: string;
  /** the full original words, opened in place */
  original: string;
  source: AgentRequestSource;
  /** "Order notes", "Text from Georgiana Torrella", "Added on site by Harrison" */
  sourceWords: string;
  atISO: string | null;
  group: AgentRequestGroup;
  /** photo / video / both / unclear (null when it is not about one) */
  medium: string | null;
  /** where the original lives, when this viewer may open it */
  link: { href: string; label: string } | null;
  /** closed words ("Confirmed by Kyle Smith, …") for history rows */
  closedWords?: string | null;
};

const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Do two requests say the same thing? Equal once normalized, or one inside the other (12+ characters) — clientAsks.sameAskWords' rule. */
export function sameRequestWords(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.includes(short);
}

const GROUP_ORDER: AgentRequestGroup[] = ["visit", "unresolved", "standing", "history"];
const SOURCE_RANK: Record<AgentRequestSource, number> = { on_site: 0, client_ask: 1, office: 2, order_note: 3, preference: 4, customer_note: 5 };

/**
 * One list: the same words from two places shown once (the earlier-ranked
 * source keeps it: the client's own ask over the office's copy of it), in
 * group order, oldest first inside a group.
 */
export function mergeAgentRequests(items: AgentRequestItem[]): AgentRequestItem[] {
  const ranked = [...items].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
  const kept: AgentRequestItem[] = [];
  for (const it of ranked) {
    if (kept.some((k) => k.group !== "history" && it.group !== "history" && sameRequestWords(k.original, it.original))) continue;
    kept.push(it);
  }
  return kept.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      (a.atISO ? Date.parse(a.atISO) : 0) - (b.atISO ? Date.parse(b.atISO) : 0),
  );
}

export const GROUP_TITLE: Record<AgentRequestGroup, string> = {
  visit: "For this shoot",
  unresolved: "Not confirmed yet",
  standing: "Standing notes and preferences",
  history: "Earlier and already handled",
};
