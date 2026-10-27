// ---------------------------------------------------------------------------
// HOW A STRATEGY PROPOSAL READS ON THE STRATEGY TAB (Oct 27 2026). Pure.
//
// Jordan, on a proposal from Bernadette's call: "So editors don't need to know
// that. The editors aren't ... weighting educational content as the default.
// Like, that wouldn't happen. It's the person who does the content strategy
// and the scripting and the planning. So it would be the content manager."
//
// A proposal changes the STRATEGY, which the content manager (strategy,
// topics, scripts) works from; editors cut the footage. The call analysis
// sometimes words a planning note at "editors", so the tab shows it addressed
// to the content manager. Display only: the stored proposal is unchanged.
//
// And on the October priorities: "why am I getting a message up here about
// this when that should be in October 2026 priorities?" A proposal that is
// about THIS month (a follow-up call, "this month", the month by name) is a
// priority for the month, not a change to the brand strategy, so the tab
// offers it inside the month's priorities instead of at the top.
// ---------------------------------------------------------------------------

const EDITOR_PHRASES: [RegExp, string][] = [
  [/\b(?:the\s+)?(?:video\s+)?editors?\s+(?:should|must|need to|needs to)\b/gi, "the content manager should"],
  [/\b(?:the\s+)?(?:video\s+)?edit(?:ing|or)?\s+team\b/gi, "the content manager"],
  [/\bfor\s+(?:the\s+)?(?:video\s+)?editors?\b/gi, "for the content manager"],
  // Not "the editor brief / packet / notes": those are the editor's own documents.
  [/\b(?:the\s+)?(?:video\s+)?editors?\b(?!\s+(?:brief|packet|notes|queue)\b)/gi, "the content manager"],
];

/** A planning note addressed to editors, addressed to the content manager instead. */
export function forContentManager(text: string): string {
  let out = text;
  for (const [re, to] of EDITOR_PHRASES) out = out.replace(re, to);
  // Sentence starts stay capitalised ("the content manager should" → "The content manager should").
  return out.replace(/(^|[.!?]\s+)the content manager/g, (_m, lead: string) => `${lead}The content manager`);
}

/**
 * Is this proposal about one month rather than the lasting strategy? It names
 * the month on screen ("October", from its label "October 2026"), "this
 * month" / "next month", or a follow-up call.
 */
export function isMonthScopedProposal(p: { summary: string; impact: string | null }, monthLabel: string): boolean {
  const text = `${p.summary} ${p.impact ?? ""}`.toLowerCase();
  const month = monthLabel.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (/\b(this|next) month\b|\bfollow-?up (strategy )?call\b|\bthis month's\b/.test(text)) return true;
  if (!/^[a-z]{3,}$/.test(month)) return false;
  // "may" is also a verb: May counts only with a day ("May 12").
  return new RegExp(month === "may" ? "\\bmay \\d{1,2}\\b" : `\\b${month}\\b`).test(text);
}

/** The proposal's kind, in plain words ("Positioning", "Audience" ...). */
export function proposalKindWord(kind: string): string {
  const k = kind.toUpperCase();
  return k === "PILLAR" ? "Content pillar" : k === "PROFILE" ? "Client profile" : k === "PREFERENCE" ? "Preference" : k.charAt(0) + k.slice(1).toLowerCase();
}

/** Where the proposal came from, in plain words. */
export function proposalSourceWord(sourceKind: string): string {
  const s = sourceKind.toLowerCase();
  return s === "client" ? "the client" : s === "call" || s.includes("call") ? "a strategy call" : s.replace(/_/g, " ");
}
