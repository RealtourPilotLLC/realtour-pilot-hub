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
  /** Oct 27 2026: the photographer said they couldn't fulfill it, and why (the job's "Not done on site" line). */
  notDone?: NotDoneView | null;
};

// ---------------------------------------------------------------------------
// "I COULDN'T FULFILL THIS" (Jordan, Oct 27 2026: "there needs to be an option
// for them to say I wasn't able to fulfill this request, and then just explain
// why"). The answer is ONE line on the job (Activity SPECIAL_REQUEST), the
// kind the editor's brief already prints under the special requests, so the
// editor knows not to look for it; and one task on Kyle's Follow-Ups so the
// client hears about it (lib/agentRequests requestNotFulfilled). The line is
// read back onto the request it is about by its words (sameRequestWords).
//   Not done on site (Harrison Wells): "Open the reel on the deck view" Why: it rained all afternoon
// ---------------------------------------------------------------------------

export type NotDoneView = { why: string; by: string | null; lineId: string | null };

export const NOT_DONE_PREFIX = "Not done on site";
export const NOT_DONE_REQUEST_CAP = 240;
export const NOT_DONE_WHY_CAP = 500;

const oneLine = (s: string, max: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** The job's line for a request not done on site. */
export function notDoneLine(by: string, request: string, why: string): string {
  return `${NOT_DONE_PREFIX} (${oneLine(by, 80) || "the photographer"}): "${oneLine(request, NOT_DONE_REQUEST_CAP)}" Why: ${oneLine(why, NOT_DONE_WHY_CAP)}`;
}

/** A "Not done on site" line read back (null = some other line). */
export function parseNotDoneLine(body: string | null | undefined): { by: string; request: string; why: string } | null {
  const m = /^Not done on site \(([^)]*)\): "([\s\S]*)" Why: ([\s\S]*)$/.exec((body ?? "").trim());
  if (!m) return null;
  return { by: m[1].trim(), request: m[2].trim(), why: m[3].trim() };
}

/** Does a "Not done on site" line belong to this request? */
export function notDoneMatches(item: Pick<AgentRequestItem, "text" | "original">, request: string): boolean {
  const r = request.replace(/…$/, "");
  return sameRequestWords(item.original, r) || sameRequestWords(item.text, r);
}

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
