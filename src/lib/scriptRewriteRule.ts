// ---------------------------------------------------------------------------
// "WRITE IT AGAIN" — WHEN A SCRIPT MAY BE WRITTEN AFRESH (Oct 23 2026).
//
// Jordan: "Give me an option to re-run the script write on the scripts."
// The office card's "Write it again" asks the hub's own writer for a fresh
// draft of the script's topic (contentGeneration.generateScriptForTopic: the
// new writer for a client switched on to it, the skit writer for a skit
// topic, exactly as the first draft). It lands as the script's next version;
// every earlier version stays in its history.
//
// It is refused, in plain words, for a script that has gone to the client
// (Jordan, Oct 21 2026: nothing ever rewrites a script already pushed to a
// client's portal), one the client approved, one whose video is filmed,
// imported history, and a bulk plan's script (the client's own words, kept
// exactly). Edit and Ask AI to revise are untouched by this rule.
//
// Pure, no imports: the card (to grey the item and say why) and the server
// (the action, and the queued job again before the model runs) read the same
// sentence.
// ---------------------------------------------------------------------------

export type RewriteFacts = {
  /** An imported record of what was filmed. */
  historical: boolean;
  /** Its video is filmed (lib/scriptFilmed). */
  filmed: boolean;
  /** The client approved a version of it on their portal. */
  clientApproved: boolean;
  /** On the client's portal now, or ever (a version shared, a share on the release ledger, a legacy client-visible row). */
  everShared: boolean;
  /** A bulk plan's script: the client's own bank, words kept exactly. */
  bulkBank: boolean;
  /** It has a topic to write from. */
  hasTopic: boolean;
  /** It belongs to a month (the writer drafts a topic for a month). */
  hasMonth: boolean;
};

export const REWRITE_REFUSED = {
  historical: "This is imported history, a record of what was filmed, so it isn't written again.",
  filmed: "This video is already filmed, so its script isn't written again.",
  clientApproved: "The client approved this script, so it isn't written again.",
  everShared: "This script has already gone to the client, so it isn't written again. Edit or Ask AI to revise still adds a version here without touching what they have.",
  bulkBank: "This is the client's own script from their bulk plan; its words are kept, so it isn't written again.",
  noTopic: "This script has no topic to write it from. Use Edit or Ask AI to revise instead.",
  noMonth: "This script isn't on a month, so it can't be written again from its topic. Use Edit or Ask AI to revise instead.",
} as const;

/** Why "Write it again" is refused for this script, or null when it may run. */
export function rewriteRefusal(f: RewriteFacts): string | null {
  if (f.historical) return REWRITE_REFUSED.historical;
  if (f.filmed) return REWRITE_REFUSED.filmed;
  if (f.clientApproved) return REWRITE_REFUSED.clientApproved;
  if (f.everShared) return REWRITE_REFUSED.everShared;
  if (f.bulkBank) return REWRITE_REFUSED.bulkBank;
  if (!f.hasTopic) return REWRITE_REFUSED.noTopic;
  if (!f.hasMonth) return REWRITE_REFUSED.noMonth;
  return null;
}

/** Legacy script statuses that meant the client could see it (before versions). */
export const LEGACY_CLIENT_STATUSES = ["CLIENT_VISIBLE", "READY_TO_FILM"] as const;
